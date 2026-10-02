"""Read-only payload injected into a running War of Dots Python runtime.

The launcher replaces __OUTPUT_PATH__ before staging this file beside a unique
copy of wod_python_probe.dll. Keep this payload self-contained: it executes in
the game's embedded Python interpreter, not the repository virtualenv.
"""

import dis
import gc
import inspect
import json
import os
import platform
import sys
import threading
import time
import traceback
import types


OUTPUT_PATH = r"""__OUTPUT_PATH__"""
FORMAT_VERSION = 1
KEYWORDS = (
    "world", "scene", "map", "game", "server", "network", "replay",
    "city", "capital", "troop", "tank", "infantry", "bridge", "player",
    "lobby", "room", "match", "mode", "generator", "connection", "socket",
)
SENSITIVE_WORDS = ("password", "passwd", "secret", "token", "credential", "cookie", "authorization")


def safe_repr(value, limit=400):
    try:
        text = repr(value)
    except Exception as exc:
        text = "<repr failed: %s>" % (exc,)
    text = text.replace("\x00", "\\x00")
    return text if len(text) <= limit else text[:limit] + "..."


def safe_signature(value):
    try:
        return str(inspect.signature(value))
    except Exception as exc:
        return "<unavailable: %s>" % (exc,)


def type_name(value):
    cls = type(value)
    return "%s.%s" % (getattr(cls, "__module__", ""), getattr(cls, "__qualname__", cls.__name__))


def sensitive_name(name):
    lowered = str(name).lower()
    return any(word in lowered for word in SENSITIVE_WORDS)


def redacted_shape(value):
    result = {"type": type_name(value), "redacted": True}
    try:
        result["length"] = len(value)
    except Exception:
        pass
    return result


def value_shape(value, depth=1):
    if value is None or isinstance(value, (bool, int, float)):
        return {"type": type(value).__name__, "value": value}
    if isinstance(value, str):
        return {"type": "str", "length": len(value), "preview": value[:240]}
    if isinstance(value, bytes):
        return {"type": "bytes", "length": len(value)}
    if isinstance(value, dict):
        keys = list(value.keys())
        item_types = {}
        if depth > 0:
            for key in keys[:80]:
                try:
                    item_types[safe_repr(key, 100)] = type_name(value[key])
                except Exception as exc:
                    item_types[safe_repr(key, 100)] = "<failed: %s>" % (exc,)
        return {
            "type": type_name(value), "length": len(value),
            "keys": [safe_repr(key, 120) for key in keys[:200]], "itemTypes": item_types,
        }
    if isinstance(value, (list, tuple, set, frozenset)):
        items = list(value)[:80]
        return {
            "type": type_name(value), "length": len(value),
            "itemTypes": sorted(set(type_name(item) for item in items)),
            "sample": [safe_repr(item, 160) for item in items[:20]],
        }
    attrs = None
    try:
        attrs = vars(value)
    except Exception:
        pass
    result = {"type": type_name(value), "repr": safe_repr(value, 240)}
    if isinstance(attrs, dict):
        result["attributeCount"] = len(attrs)
        result["attributeNames"] = [str(name) for name in list(attrs)[:240]]
    return result


def literal_tree(value, depth=6, budget=None):
    """Preserve safe generator constants without serializing arbitrary objects."""
    if budget is None:
        budget = [4000]
    budget[0] -= 1
    if budget[0] < 0:
        return "<budget exhausted>"
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return value if len(value) <= 1000 else value[:1000] + "..."
    if depth <= 0:
        return safe_repr(value, 240)
    if isinstance(value, dict):
        return {
            safe_repr(key, 160): literal_tree(child, depth - 1, budget)
            for key, child in list(value.items())[:1000]
        }
    if isinstance(value, (list, tuple, set, frozenset)):
        return [literal_tree(child, depth - 1, budget) for child in list(value)[:1000]]
    return {"type": type_name(value), "repr": safe_repr(value, 240)}


def code_metadata(value):
    code = getattr(value, "__code__", None)
    if not isinstance(code, types.CodeType):
        return None
    constants = []
    for constant in code.co_consts[:160]:
        if isinstance(constant, types.CodeType):
            constants.append({"code": constant.co_name, "argcount": constant.co_argcount})
        else:
            constants.append(value_shape(constant, depth=0))
    instructions = []
    try:
        for index, instruction in enumerate(dis.get_instructions(value)):
            if index >= 800:
                instructions.append({"truncated": True})
                break
            instructions.append({
                "offset": instruction.offset,
                "opname": instruction.opname,
                "argrepr": instruction.argrepr,
                "line": instruction.starts_line,
            })
    except Exception as exc:
        instructions = [{"error": repr(exc)}]
    return {
        "filename": code.co_filename,
        "firstLine": code.co_firstlineno,
        "argCount": code.co_argcount,
        "positionalOnlyArgCount": getattr(code, "co_posonlyargcount", 0),
        "keywordOnlyArgCount": code.co_kwonlyargcount,
        "localCount": code.co_nlocals,
        "flags": code.co_flags,
        "varNames": list(code.co_varnames),
        "names": list(code.co_names),
        "freeVars": list(code.co_freevars),
        "cellVars": list(code.co_cellvars),
        "constants": constants,
        "instructions": instructions,
    }


def callable_metadata(name, value):
    result = {
        "name": str(name),
        "type": type_name(value),
        "module": getattr(value, "__module__", None),
        "qualname": getattr(value, "__qualname__", None),
        "signature": safe_signature(value),
        "repr": safe_repr(value, 300),
    }
    for attr in ("__text_signature__", "__defaults__", "__kwdefaults__", "__annotations__"):
        try:
            child = getattr(value, attr, None)
        except Exception:
            child = None
        if child is not None:
            result[attr] = value_shape(child)
    code = code_metadata(value)
    if code is not None:
        result["code"] = code
    return result


def class_metadata(cls):
    attrs = {}
    try:
        class_vars = dict(vars(cls))
    except Exception as exc:
        class_vars = {}
        attrs["<vars error>"] = {"error": repr(exc)}
    for name, value in class_vars.items():
        if name in ("__dict__", "__weakref__"):
            continue
        if callable(value) or isinstance(value, (classmethod, staticmethod)):
            target = getattr(value, "__func__", value)
            attrs[str(name)] = {"kind": "callable", **callable_metadata(name, target)}
        else:
            attrs[str(name)] = {
                "kind": "data",
                **(redacted_shape(value) if sensitive_name(name) else value_shape(value)),
            }
    try:
        bases = ["%s.%s" % (base.__module__, base.__qualname__) for base in cls.__bases__]
        mro = ["%s.%s" % (base.__module__, base.__qualname__) for base in cls.__mro__]
    except Exception:
        bases, mro = [], []
    return {
        "name": getattr(cls, "__name__", safe_repr(cls, 100)),
        "qualname": getattr(cls, "__qualname__", None),
        "module": getattr(cls, "__module__", None),
        "bases": bases,
        "mro": mro,
        "attributeCount": len(class_vars),
        "attributes": attrs,
    }


def instance_metadata(obj):
    try:
        attrs = dict(vars(obj))
    except Exception:
        return None
    shaped = {}
    for name, value in list(attrs.items())[:500]:
        try:
            shaped[str(name)] = redacted_shape(value) if sensitive_name(name) else value_shape(value)
        except Exception as exc:
            shaped[str(name)] = {"error": repr(exc)}
    cls = type(obj)
    result = {
        "id": hex(id(obj)),
        "class": getattr(cls, "__name__", safe_repr(cls, 100)),
        "classQualname": getattr(cls, "__qualname__", None),
        "module": getattr(cls, "__module__", None),
        "attributeCount": len(attrs),
        "attributes": shaped,
    }
    if getattr(cls, "__name__", "") == "MapGenerator":
        result["literalAttributes"] = {
            str(name): literal_tree(value) for name, value in attrs.items()
        }
    return result


def is_interesting_class(cls):
    name = "%s.%s" % (getattr(cls, "__module__", ""), getattr(cls, "__qualname__", ""))
    lowered = name.lower()
    return getattr(cls, "__module__", None) == "__main__" or any(word in lowered for word in KEYWORDS)


def module_metadata(name, module):
    result = {
        "name": name,
        "file": getattr(module, "__file__", None),
        "package": getattr(module, "__package__", None),
    }
    try:
        attrs = dict(vars(module))
    except Exception as exc:
        result["error"] = repr(exc)
        return result
    result["attributeCount"] = len(attrs)
    result["classes"] = sorted(
        key for key, value in attrs.items() if isinstance(value, type)
    )[:500]
    result["callables"] = sorted(
        key for key, value in attrs.items() if callable(value) and not isinstance(value, type)
    )[:1000]
    return result


def pygame_metadata():
    result = {}
    pygame = sys.modules.get("pygame")
    if pygame is None:
        return result
    try:
        result["version"] = getattr(getattr(pygame, "version", None), "ver", None)
        result["displayInitialized"] = pygame.display.get_init()
        result["surfaceSize"] = pygame.display.get_surface().get_size() if pygame.display.get_surface() else None
        result["driver"] = pygame.display.get_driver() if pygame.display.get_init() else None
    except Exception as exc:
        result["error"] = repr(exc)
    return result


def capture():
    started = time.time()
    main = sys.modules.get("__main__")
    main_vars = dict(vars(main)) if main is not None else {}

    discovered_classes = {}
    for name, value in main_vars.items():
        if isinstance(value, type):
            discovered_classes[id(value)] = value
    for obj in gc.get_objects():
        try:
            if isinstance(obj, type) and is_interesting_class(obj):
                discovered_classes[id(obj)] = obj
        except Exception:
            pass

    classes = []
    class_ids = set()
    for cls in sorted(discovered_classes.values(), key=lambda value: (
        getattr(value, "__module__", ""), getattr(value, "__qualname__", "")
    )):
        if len(classes) >= 1600:
            break
        try:
            classes.append(class_metadata(cls))
            class_ids.add(id(cls))
        except Exception as exc:
            classes.append({"name": safe_repr(cls), "error": repr(exc)})

    instances = []
    instance_counts = {}
    for obj in gc.get_objects():
        if len(instances) >= 5000:
            break
        try:
            cls = type(obj)
            if id(cls) not in class_ids:
                continue
            key = "%s.%s" % (getattr(cls, "__module__", ""), getattr(cls, "__qualname__", ""))
            instance_counts[key] = instance_counts.get(key, 0) + 1
            item = instance_metadata(obj)
            if item is not None:
                instances.append(item)
        except Exception:
            pass

    globals_out = {}
    for name, value in sorted(main_vars.items()):
        if name.startswith("__") and name.endswith("__"):
            continue
        try:
            if callable(value) and not isinstance(value, type):
                globals_out[name] = {"kind": "callable", **callable_metadata(name, value)}
            elif isinstance(value, type):
                globals_out[name] = {
                    "kind": "class",
                    "module": getattr(value, "__module__", None),
                    "qualname": getattr(value, "__qualname__", None),
                }
            else:
                globals_out[name] = {
                    "kind": "data",
                    **(redacted_shape(value) if sensitive_name(name) else value_shape(value)),
                }
        except Exception as exc:
            globals_out[name] = {"error": repr(exc)}

    modules = []
    for name, module in sorted(sys.modules.items()):
        if module is None:
            continue
        try:
            modules.append(module_metadata(name, module))
        except Exception as exc:
            modules.append({"name": name, "error": repr(exc)})

    threads = []
    for thread in threading.enumerate():
        threads.append({
            "name": thread.name,
            "daemon": thread.daemon,
            "alive": thread.is_alive(),
            "ident": thread.ident,
            "nativeId": getattr(thread, "native_id", None),
        })

    return {
        "formatVersion": FORMAT_VERSION,
        "capturedAt": int(time.time()),
        "captureDurationSeconds": round(time.time() - started, 3),
        "process": {
            "pid": os.getpid(),
            "executable": sys.executable,
            "cwd": os.getcwd(),
            "argv": list(sys.argv),
            "pythonVersion": sys.version,
            "pythonImplementation": platform.python_implementation(),
            "platform": platform.platform(),
        },
        "pygame": pygame_metadata(),
        "gc": {"counts": list(gc.get_count()), "objectCount": len(gc.get_objects())},
        "threads": threads,
        "moduleCount": len(modules),
        "modules": modules,
        "mainGlobalCount": len(globals_out),
        "mainGlobals": globals_out,
        "classCount": len(classes),
        "classes": classes,
        "instanceCount": len(instances),
        "instanceCountsByClass": instance_counts,
        "instances": instances,
    }


def write_atomic(value):
    directory = os.path.dirname(OUTPUT_PATH)
    if directory:
        os.makedirs(directory, exist_ok=True)
    temporary = OUTPUT_PATH + ".tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2, ensure_ascii=False, default=safe_repr)
    os.replace(temporary, OUTPUT_PATH)


try:
    write_atomic({"status": "ok", "runtime": capture()})
except Exception as exc:
    write_atomic({
        "status": "failed",
        "message": str(exc),
        "traceback": traceback.format_exc(),
    })
