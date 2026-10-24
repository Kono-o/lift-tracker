export interface UndoToast {
  label: string;
  durationMs?: number;
  onUndo?: () => void;
}

let toast: UndoToast | null = $state(null);

export function currentToast(): UndoToast | null {
  return toast;
}

export function showUndoToast(t: UndoToast): void {
  toast = t;
}

export function dismissUndoToast(): void {
  toast = null;
}
