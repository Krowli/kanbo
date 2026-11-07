/** The seven tones a label chip takes; the stylesheet gives each its colours. */
export const LABEL_TONES = ['blue', 'emerald', 'amber', 'rose', 'violet', 'cyan', 'slate'] as const

export type LabelTone = typeof LABEL_TONES[number]

/** A tone picked by a hash of the label's text, so a label keeps its colour on every card and in every list. */
export function labelTone(label: string): LabelTone {
  let hash = 5381
  for (let index = 0; index < label.length; index++) {
    hash = ((hash << 5) + hash + label.charCodeAt(index)) | 0
  }
  return LABEL_TONES[Math.abs(hash) % LABEL_TONES.length]!
}
