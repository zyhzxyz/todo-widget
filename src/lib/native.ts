import { getCurrentWindow } from '@tauri-apps/api/window';

/** Browser preview/web deployment must not crash while reading Tauri window metadata. */
export function mainWindow() {
  try {
    const window = getCurrentWindow();
    return {
      native: true,
      setAlwaysOnTop: (value: boolean) => window.setAlwaysOnTop(value),
      startDragging: () => window.startDragging(),
      minimize: () => window.minimize(),
      close: () => window.close(),
    };
  } catch {
    const noop = async () => {};
    return { native: false, setAlwaysOnTop: async (_value: boolean) => {}, startDragging: noop, minimize: noop, close: noop };
  }
}
