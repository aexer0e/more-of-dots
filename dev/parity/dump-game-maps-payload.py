# Runs inside a running War of Dots through the Python probe. Writes the game's
# built-in map table (layouts of starting units, cities, capitals and bridges for
# every official map) as JSON. It reads the table and changes nothing.
import json
import os
import sys
import time
import traceback

OUTPUT_PATH = r'''__OUTPUT_PATH__'''


def plain(value):
    # NumPy arrays and scalars become lists and numbers.
    if hasattr(value, 'tolist'):
        return plain(value.tolist())
    if isinstance(value, dict):
        return {str(key): plain(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [plain(item) for item in value]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    raise TypeError(f'Unexpected map value: {type(value).__name__}')


try:
    main = sys.modules['__main__']
    deadline = time.monotonic() + 60
    while not hasattr(main, 'maps'):
        if time.monotonic() > deadline:
            raise RuntimeError('The game has not loaded its maps; open the main menu first.')
        time.sleep(0.25)
    result = {'game_version': getattr(main, 'version', None), 'maps': plain(main.maps)}
    temporary = OUTPUT_PATH + '.tmp'
    with open(temporary, 'w', encoding='utf-8') as file:
        json.dump(result, file)
    os.replace(temporary, OUTPUT_PATH)
except Exception:
    with open(OUTPUT_PATH + '.error.txt', 'w', encoding='utf-8') as file:
        file.write(traceback.format_exc())
