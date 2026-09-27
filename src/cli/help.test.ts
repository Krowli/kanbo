import type { Command } from 'commander'
import { describe, expect, it } from 'vitest'

import { createKanboProgram } from './program'

/** Words a person new to kanbo should not have to learn from `--help`. */
const JARGON = ['binding', 'spelled out', 'host database', 'the launches of a card', 'external board']

/** A program whose help is the same on every machine: 80 columns, whatever the terminal. */
function program(): Command {
  const kanbo = createKanboProgram()
  const fixed = (command: Command): void => {
    command.configureHelp({ helpWidth: 80 })
    command.commands.forEach(fixed)
  }
  fixed(kanbo)
  return kanbo
}

function find(root: Command, name: string): Command {
  return root.commands.find(command => command.name() === name)!
}

/** Every description `--help` can show: each command's, its arguments' and its options'. */
function descriptions(command: Command): string[] {
  return command.commands.flatMap(child => [
    `${child.name()}: ${child.description()}`,
    ...child.registeredArguments.map(argument => `${child.name()} <${argument.name()}>: ${argument.description}`),
    ...child.options.map(option => `${child.name()} ${option.flags}: ${option.description}`),
    ...descriptions(child),
  ])
}

describe('kanbo --help', () => {
  it('groups the commands and says what each is for', () => {
    expect(program().helpInformation()).toMatchSnapshot()
  })

  it('explains init', () => {
    expect(find(program(), 'init').helpInformation()).toMatchSnapshot()
  })

  it('speaks without jargon, in every command, argument and option', () => {
    const found = descriptions(program())
      .filter(line => JARGON.some(word => line.toLowerCase().includes(word)))
    expect(found).toEqual([])
  })
})
