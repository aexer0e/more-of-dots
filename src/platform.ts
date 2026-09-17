import { invoke as nativeInvoke } from '@tauri-apps/api/core';

export const exampleMode = import.meta.env.DEV && import.meta.env.VITE_EXAMPLE_DATA === '1';
export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (exampleMode) return (await import('./dev/examples')).exampleInvoke<T>(command, args);
  return nativeInvoke<T>(command, args);
}
