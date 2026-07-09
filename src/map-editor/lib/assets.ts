const appIcon = new URL('../assets/WarOfDots_icon.png', import.meta.url).href;
const logo = new URL('../assets/logo.png', import.meta.url).href;
const city = new URL('../assets/city_icon.png', import.meta.url).href;
const capital = new URL('../assets/capital.png', import.meta.url).href;
const fill = new URL('../assets/fill_icon.svg', import.meta.url).href;

const blueFlag = new URL('../assets/blue_flag.png', import.meta.url).href;
const orangeFlag = new URL('../assets/orange_flag.png', import.meta.url).href;
const redFlag = new URL('../assets/red_flag.png', import.meta.url).href;
const purpleFlag = new URL('../assets/purple_flag.png', import.meta.url).href;

const blueInfantry = new URL('../assets/blue_inf1.png', import.meta.url).href;
const orangeInfantry = new URL('../assets/orange_inf1.png', import.meta.url).href;
const redInfantry = new URL('../assets/red_inf1.png', import.meta.url).href;
const purpleInfantry = new URL('../assets/purple_inf1.png', import.meta.url).href;

const blueTank = new URL('../assets/blue_tank1.png', import.meta.url).href;
const orangeTank = new URL('../assets/orange_tank1.png', import.meta.url).href;
const redTank = new URL('../assets/red_tank1.png', import.meta.url).href;
const purpleTank = new URL('../assets/purple_tank1.png', import.meta.url).href;

export const uiAssets = {
  appIcon,
  logo,
  city,
  capital,
  fill,
};

export const spriteAssets = {
  blue: { infantry: blueInfantry, tank: blueTank },
  orange: { infantry: orangeInfantry, tank: orangeTank },
  red: { infantry: redInfantry, tank: redTank },
  purple: { infantry: purpleInfantry, tank: purpleTank },
} as const;

export const flagAssets = {
  blue: blueFlag,
  orange: orangeFlag,
  red: redFlag,
  purple: purpleFlag,
} as const;

const imageCache = new Map<string, HTMLImageElement>();

export function getCachedImage(src: string) {
  let image = imageCache.get(src);
  if (!image) {
    image = new Image();
    image.src = src;
    imageCache.set(src, image);
  }
  return image;
}

export async function preloadImages(sources: string[]) {
  await Promise.all(
    sources.map(
      (source) =>
        new Promise<void>((resolve) => {
          const image = getCachedImage(source);
          if (image.complete) {
            resolve();
            return;
          }
          image.onload = () => resolve();
          image.onerror = () => resolve();
        }),
    ),
  );
}
