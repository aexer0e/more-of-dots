# Replay renderer dependencies

The independent renderer uses SDL 2, SDL_image 2, SDL_ttf 2, FreeType, libpng and zlib. These are general graphics/font libraries; no War of Dots executable, Python runtime or game module is loaded. Windows OpenGL and Arial are supplied by Windows.

Upstream projects and source/licensing information:

- SDL: https://github.com/libsdl-org/SDL/tree/SDL2 (zlib license)
- SDL_image: https://github.com/libsdl-org/SDL_image/tree/SDL2 (zlib license)
- SDL_ttf: https://github.com/libsdl-org/SDL_ttf/tree/SDL2 (zlib license)
- FreeType: https://freetype.org/license.html (FreeType license)
- libpng: http://www.libpng.org/pub/png/src/libpng-LICENSE.txt
- zlib: https://zlib.net/zlib_license.html

MP4 export uses the H.264 encoder in Windows Media Foundation, which is part of Windows; no video encoder is bundled.

No music or sound effects are bundled. Replays and exported videos play War of Dots' own sounds (`assets/music/won.wav` and `assets/sound_effects/*.wav`) from the installed game, in place.
