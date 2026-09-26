/**
 * The one way the page makes an element: its tag, its class and its text, the
 * text set as `textContent`. Nothing the board holds is ever parsed as HTML —
 * a card titled `<img onerror=…>` is shown as those characters.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  if (className) {
    element.className = className
  }
  if (text !== undefined) {
    element.textContent = text
  }
  return element
}

/** A `type="button"` button, so none of them ever submits a form by accident. */
export function button(text: string, className: string, onClick: () => void): HTMLButtonElement {
  const element = el('button', className, text)
  element.type = 'button'
  element.addEventListener('click', onClick)
  return element
}
