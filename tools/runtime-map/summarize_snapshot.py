"""Build a compact, case-sensitive index from a raw runtime capture."""

import json
import pathlib
import sys


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: summarize_snapshot.py <runtime.json> <summary.json>")
    runtime_path = pathlib.Path(sys.argv[1])
    summary_path = pathlib.Path(sys.argv[2])
    result = json.loads(runtime_path.read_text(encoding="utf-8-sig"))
    if result.get("status") != "ok":
        raise RuntimeError("runtime probe failed: %s" % result.get("message", "unknown error"))
    runtime = result["runtime"]
    target_names = ("WorldModeScene", "MapGenerator", "ServerManager", "ReplayManager")
    target_classes = []
    main_classes = []
    for candidate in runtime.get("classes", []):
        methods = []
        data_attributes = []
        for name, value in candidate.get("attributes", {}).items():
            if value.get("kind") == "callable":
                methods.append({"name": name, "signature": value.get("signature")})
            elif not name.startswith("__"):
                data_attributes.append(name)
        if candidate.get("module") == "__main__":
            main_classes.append({
                "name": candidate.get("name"),
                "qualname": candidate.get("qualname"),
                "bases": candidate.get("bases", []),
                "methods": methods,
                "dataAttributes": data_attributes,
            })
        searchable = "%s %s" % (candidate.get("name", ""), candidate.get("qualname", ""))
        if not any(name in searchable for name in target_names):
            continue
        target_classes.append({
            "name": candidate.get("name"),
            "qualname": candidate.get("qualname"),
            "module": candidate.get("module"),
            "bases": candidate.get("bases", []),
            "methods": methods,
        })
    summary = {
        "formatVersion": 1,
        "capturedAt": runtime.get("capturedAt"),
        "processId": runtime.get("process", {}).get("pid"),
        "pythonVersion": runtime.get("process", {}).get("pythonVersion"),
        "pygame": runtime.get("pygame", {}),
        "moduleCount": runtime.get("moduleCount", 0),
        "mainGlobalCount": runtime.get("mainGlobalCount", 0),
        "classCount": runtime.get("classCount", 0),
        "instanceCount": runtime.get("instanceCount", 0),
        "targetClasses": target_classes,
        "mainClasses": main_classes,
        "mainCallables": [
            {"name": name, "signature": value.get("signature")}
            for name, value in runtime.get("mainGlobals", {}).items()
            if value.get("kind") == "callable"
        ],
        "instanceCountsByClass": runtime.get("instanceCountsByClass", {}),
        # Preserve live game-owned state in a compact lookup surface. Attribute
        # values have already been bounded and redacted by runtime_probe.py.
        "liveMainInstances": [
            {
                "id": instance.get("id"),
                "class": instance.get("class"),
                "classQualname": instance.get("classQualname"),
                "attributeCount": instance.get("attributeCount", 0),
                "attributes": instance.get("attributes", {}),
            }
            for instance in runtime.get("instances", [])
            if instance.get("module") == "__main__"
        ],
    }
    summary_path.write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({
        "classCount": summary["classCount"],
        "instanceCount": summary["instanceCount"],
        "targetClassCount": len(target_classes),
        "liveMainInstanceCount": len(summary["liveMainInstances"]),
    }))


if __name__ == "__main__":
    main()
