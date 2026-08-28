import { z } from 'zod'

export const IDEA_DESCRIPTION_MAX_LENGTH = 64_000

const dutchNumber = new Intl.NumberFormat('nl-NL')

function lengthError(description: string): string | null {
  const length = Array.from(description).length
  if (length <= IDEA_DESCRIPTION_MAX_LENGTH) return null

  const overflow = length - IDEA_DESCRIPTION_MAX_LENGTH
  return `Beschrijving bevat ${dutchNumber.format(length)} tekens; verwijder ${dutchNumber.format(overflow)} ${overflow === 1 ? 'teken' : 'tekens'}. Maximaal ${dutchNumber.format(IDEA_DESCRIPTION_MAX_LENGTH)} toegestaan.`
}

export const ideaDescriptionSchema = z.string().superRefine((description, ctx) => {
  const message = lengthError(description)
  if (message) {
    ctx.addIssue({ code: 'custom', message })
  }
})
