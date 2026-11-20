/** Copies text to the clipboard; false when the browser refuses (insecure origin, denied). */
export function useClipboard() {
  async function copy(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }
  return { copy };
}
