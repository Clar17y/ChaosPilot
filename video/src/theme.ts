export const THEME = {
  colors: {
    bgPrimary: '#060a10',
    bgSurface: '#0c131d',
    bgSurfaceGlass: 'rgba(12, 19, 29, 0.88)',
    bgSubtle: '#111b28',
    bgRaised: '#162233',
    borderColor: 'rgba(130, 170, 200, 0.16)',
    borderStrong: 'rgba(105, 199, 219, 0.34)',
    hairline: 'rgba(130, 170, 200, 0.11)',
    textMain: '#f3f6fa',
    textMuted: '#9dafc2',
    textDim: '#6c8096',
    accentCyan: '#69c7db',
    accentBright: '#8ad9ea',
    accentGreen: '#4fd19b',
    accentRed: '#e07a6a', // coral
    accentAmber: '#d9a84e',
    accentViolet: '#a996f7',
    accentBlue: '#3888a8',
  },
  fonts: {
    sans: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    mono: '"Cascadia Mono", Consolas, "JetBrains Mono", Menlo, monospace',
  },
  safeArea: {
    top: 60,
    bottom: 60,
    left: 80,
    right: 80,
  },
};

export const SCENE_DURATIONS = {
  scene01: 300, // 0-10s (10s)
  scene02: 420, // 10-24s (14s)
  scene03: 360, // 24-36s (12s)
  scene04: 420, // 36-50s (14s)
  scene05: 420, // 50-64s (14s)
  scene06: 420, // 64-78s (14s)
  scene07: 480, // 78-94s (16s)
  scene08: 420, // 94-108s (14s)
  scene09: 420, // 108-122s (14s)
  scene10: 360, // 122-134s (12s)
  scene11: 360, // 134-146s (12s)
  scene12: 360, // 146-158s (12s)
  scene13: 360, // 158-170s (12s)
  scene14: 300, // 170-180s (10s)
} as const;

export const TOTAL_FRAMES = 5400;
export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;
