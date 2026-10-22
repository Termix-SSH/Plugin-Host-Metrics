import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleLayoutHistoryKeyDown } from "../../src/frontend/layout-history-shortcuts";

afterEach(cleanup);

function mount(
  options: {
    editMode?: boolean;
    isVisible?: boolean;
    canUndo?: boolean;
    canRedo?: boolean;
    prevented?: boolean;
  } = {},
) {
  const history = {
    editMode: true,
    isVisible: true,
    canUndo: true,
    canRedo: true,
    undo: vi.fn(),
    redo: vi.fn(),
    ...options,
  };
  const parent = vi.fn();
  const view = render(
    <div onKeyDown={parent}>
      <main
        data-testid="tab"
        onKeyDown={(event) => {
          if (options.prevented) event.preventDefault();
          handleLayoutHistoryKeyDown(event, history);
        }}
      >
        <button>Layout control</button>
      </main>
      <button>Outside tab</button>
    </div>,
  );
  return { ...view, history, parent };
}

function key(target: Element, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key: "z",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  fireEvent(target, event);
  return event;
}

describe("layout history shortcuts", () => {
  it.each([
    ["Ctrl+Z", { key: "z" }, "undo"],
    ["Ctrl+Y", { key: "y" }, "redo"],
    ["Ctrl+Shift+Z", { key: "Z", shiftKey: true }, "redo"],
    ["Meta+Z", { key: "z", ctrlKey: false, metaKey: true }, "undo"],
    [
      "Meta+Shift+Z",
      { key: "Z", ctrlKey: false, metaKey: true, shiftKey: true },
      "redo",
    ],
  ] as const)(
    "handles %s only within the visible editing tab",
    (_name, options, action) => {
      const { history, parent } = mount();
      const event = key(screen.getByText("Layout control"), options);
      expect(event.defaultPrevented).toBe(true);
      expect(history[action]).toHaveBeenCalledTimes(1);
      expect(
        history[action === "undo" ? "redo" : "undo"],
      ).not.toHaveBeenCalled();
      expect(parent).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["view mode", { editMode: false }, {}],
    ["hidden tab", { isVisible: false }, {}],
    ["empty undo", { canUndo: false }, {}],
    ["empty redo", { canRedo: false }, { key: "y" }],
    ["already handled", { prevented: true }, {}],
    ["no modifier", {}, { ctrlKey: false }],
    ["Alt combination", {}, { altKey: true }],
    ["IME composition", {}, { isComposing: true }],
    ["other shortcut", {}, { key: "a" }],
  ])("leaves %s untouched", (_name, options, keyboard) => {
    const { history, parent } = mount(options);
    const event = key(screen.getByText("Layout control"), keyboard);
    expect(history.undo).not.toHaveBeenCalled();
    expect(history.redo).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(
      Boolean("prevented" in options && options.prevented),
    );
    expect(parent).toHaveBeenCalledTimes(1);
  });

  it.each([
    "<input />",
    "<textarea></textarea>",
    "<select><option>One</option></select>",
    '<div contenteditable="true"><span>Rich text</span></div>',
    '<div contenteditable=""><span>Editable</span></div>',
    '<div contenteditable="plaintext-only"><span>Plain text</span></div>',
    '<div role="textbox"><span>Text editor</span></div>',
    '<div role="combobox"><span>Search</span></div>',
    '<div class="monaco-editor"><div>Code</div></div>',
    '<div class="cm-editor"><div>Code</div></div>',
    '<div class="ace_editor"><div>Code</div></div>',
  ])("preserves native/editor undo and redo in %s", (html) => {
    const { history } = mount();
    const fixture = document.createElement("div");
    fixture.innerHTML = html;
    screen.getByTestId("tab").appendChild(fixture);
    const target = fixture.querySelector(
      "span, input, textarea, option, .monaco-editor > div, .cm-editor > div, .ace_editor > div",
    )!;
    for (const options of [
      { key: "z" },
      { key: "y" },
      { key: "Z", shiftKey: true },
    ]) {
      expect(key(target, options).defaultPrevented).toBe(false);
    }
    expect(history.undo).not.toHaveBeenCalled();
    expect(history.redo).not.toHaveBeenCalled();
  });

  it("does not listen to events outside this tab", () => {
    const { history } = mount();
    expect(key(screen.getByText("Outside tab")).defaultPrevented).toBe(false);
    expect(history.undo).not.toHaveBeenCalled();
    expect(history.redo).not.toHaveBeenCalled();
  });

  it("ignores history while a resize preview is active", () => {
    const { history } = mount();
    const preview = document.createElement("div");
    preview.dataset.hmResizing = "true";
    screen.getByTestId("tab").appendChild(preview);
    const target = screen.getByText("Layout control");
    expect(key(target).defaultPrevented).toBe(false);
    expect(key(target, { key: "y" }).defaultPrevented).toBe(false);
    expect(history.undo).not.toHaveBeenCalled();
    expect(history.redo).not.toHaveBeenCalled();
    preview.remove();
    expect(key(target).defaultPrevented).toBe(true);
    expect(history.undo).toHaveBeenCalledTimes(1);
  });
});
