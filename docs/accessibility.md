# Accessibility

The app aims to meet WCAG 2.1 AA. Every screen works with a keyboard alone and with a screen reader.

## Keyboard

| Where | Keys |
| --- | --- |
| Any screen | The first **Tab** shows **Skip to content**, which jumps past the header. After you move to another screen, focus starts at its heading. |
| A page's **⋯** menu | **Enter**, **Space** or **↓** opens it on the first item, **↑** on the last. **↑** and **↓** move between items, **Home** and **End** go to the first and last. **Escape** closes it and returns focus to the button. |
| Your name and the workspace switcher in the header | **Enter** or **Space** opens the list. **↑** and **↓** move through it, **Tab** moves on and closes it, **Escape** closes it and returns focus to the button. |
| Gallery tabs | **←** and **→** switch between your pages and **Shared with you**. |
| Dialogs (**Share**, **Rename**, **Move to folder**, **Duplicate**, **Move to workspace**, **Tags**, **Delete**, and the folder dialogs **New folder**, **Rename folder** and **Delete folder**) | Focus moves into the dialog and stays there while you tab. **Escape** closes it and returns focus to the button that opened it. |
| Buttons that ask before they act (**Delete**, **Revoke**, **Remove**, **Suspend**) | Focus moves to the button that confirms, or to the field where you type to confirm. **Cancel** returns focus to the button you started from. |
| **History** and **Comments** | The panel takes focus when it opens. **Escape** closes it and returns focus to its button. In a reply or an edit, **Ctrl+Enter** (**⌘+Enter** on a Mac) sends it and **Escape** cancels it without closing the panel. |

The focused control always has a visible outline.

## Screen readers

Buttons that only show an icon have a text label. Results that appear without a new screen, such as search results, a saved setting or a copied link, are announced. Form errors are read out with the field they belong to.

## Motion and colour

With **Reduce motion** turned on in your system settings, the app has no animations or transitions. Text and controls meet the AA contrast ratios.

## Published pages

A published page is shown as the agent wrote it, in a frame titled with the page's name. The app doesn't change or check its content, so its accessibility is up to whoever publishes it. To ask your agent for an accessible page, say so when you ask it to publish.

## How it is checked

The end-to-end tests run [axe](https://github.com/dequelabs/axe-core) with the WCAG 2.1 A and AA rules on every main screen, and drive sign-in, the gallery, sharing, history, comments, menus and settings with the keyboard alone.
