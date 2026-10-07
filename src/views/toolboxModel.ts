/** The Toolbox's groups, shared by the side bar Toolbox view and the palette docked in the designer. */
import type { Registry } from '../project/webProject'

export interface ToolboxItem {
  name: string
  doc: string
  project: boolean
}

export interface ToolboxGroup {
  name: string
  items: ToolboxItem[]
}

const FAMILY_LABELS: Record<string, string> = {
  core: 'Common Controls',
  containers: 'Containers',
  text: 'Text',
  display: 'Display',
  choice: 'Choice',
  data: 'Data',
  docking: 'Docking',
  navigation: 'Navigation',
  components: 'Components',
}

export function toolboxGroups(registry: Registry | null): ToolboxGroup[] {
  const groups = new Map<string, ToolboxItem[]>()
  const add = (group: string, item: ToolboxItem): void => {
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group)!.push(item)
  }
  for (const c of registry?.components ?? []) {
    if (c.browsable === false) continue
    const project = c.origin === 'project'
    const group = project ? 'Project Controls' : (c.toolbox_category as string) || FAMILY_LABELS[c.family ?? ''] || c.family || 'Other'
    add(group, { name: c.name, doc: c.doc ?? '', project })
  }
  for (const u of registry?.userControls ?? []) add('User Controls', { name: u.name, doc: u.module, project: true })
  return [...groups.entries()].map(([name, items]) => ({ name, items: items.sort((a, b) => a.name.localeCompare(b.name)) }))
}
