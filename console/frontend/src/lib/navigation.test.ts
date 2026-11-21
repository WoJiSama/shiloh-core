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

    expect(entries).toHaveLength(18)
    expect(entries.every(([, item]) => sections.has(item.group))).toBe(true)
    expect(workspaceFeatureEntries('/connections').map(([key]) => key)).toEqual([
      'groups',
      'group-admin'
    ])
  })

  it('keeps legacy module paths available for the secondary navigation', () => {
    expect(workspaceFeaturePath('semantic')).toBe('/semantic')
    expect(workspaceFeaturePath('draw')).toBe('/draw')
    expect(workspaceFeaturePath('group-admin')).toBe('/group-admin')
    expect(workspaceFeaturePath('groups')).toBe('/connections')
  })
})
