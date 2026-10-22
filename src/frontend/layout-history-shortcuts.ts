import type { KeyboardEvent } from "react";

export function handleLayoutHistoryKeyDown(
  event: KeyboardEvent<HTMLElement>,
  history: {
    editMode: boolean;
    isVisible: boolean;
    canUndo: boolean;
    canRedo: boolean;
    undo: () => void;
    redo: () => void;
  },
) {
  if (
    !history.editMode ||
    !history.isVisible ||
    event.defaultPrevented ||
    event.nativeEvent.isComposing ||
    event.altKey ||
    !(event.ctrlKey || event.metaKey)
  )
    return;
  const target = event.target;
  if (
    !(target instanceof Element) ||
    target.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], .monaco-editor, .cm-editor, .ace_editor',
    ) ||
    // Ignore history during a drag so a stale pointerup cannot overwrite it.
    event.currentTarget.querySelector('[data-hm-resizing="true"]')
  )
    return;
  const key = event.key.toLowerCase();
  const redo = key === "y" || (key === "z" && event.shiftKey);
  if (key !== "z" && key !== "y") return;
  if (redo ? !history.canRedo : !history.canUndo) return;
  event.preventDefault();
  event.stopPropagation();
  if (redo) history.redo();
  else history.undo();
}
