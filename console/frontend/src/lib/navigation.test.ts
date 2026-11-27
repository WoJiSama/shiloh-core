import { describe, expect, it } from 'vitest'
import {
  workspaceFeatureEntries,
  workspaceFeaturePath,
  workspaceFeatures,
  workspaceNavigation
} from './navigation'

describe('standalone workspace navigation', () => {
  it('keeps every feature discoverable from exactly one visible section', () => {
    const sections = new Set(workspaceNavigation.map((item) => item.path))
    const entries = Object.entries(workspaceFeatures)

    expect(entries.every(([, item]) => sections.has(item.group))).toBe(true)
    expect(workspaceFeatureEntries('/system').map(([key]) => key)).toContain('feature-switches')
    expect(workspaceFeatureEntries('/connections').map(([key]) => key)).toEqual([
      'groups',
      'group-admin'
    ])
  })

  it('places dice and games together near the top of the sidebar', () => {
    expect(workspaceNavigation.map((item) => item.path).slice(0, 5)).toEqual([
      '/',
      '/robots',
      '/connections',
      '/features',
      '/resources'
    ])
    expect(workspaceFeatureEntries('/features').map(([key, item]) => [key, item.label])).toEqual([
      ['commands', '骰子'],
      ['games', '游戏']
    ])
  })

  it('keeps legacy module paths available for the secondary navigation', () => {
    expect(workspaceFeaturePath('semantic')).toBe('/semantic')
    expect(workspaceFeaturePath('draw')).toBe('/draw')
    expect(workspaceFeaturePath('group-admin')).toBe('/group-admin')
    expect(workspaceFeaturePath('groups')).toBe('/connections')
    expect(workspaceFeaturePath('commands')).toBe('/commands')
    expect(workspaceFeaturePath('games')).toBe('/games')
  })
})
