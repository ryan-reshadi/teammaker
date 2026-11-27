import type { GroupTag } from '../../shared/types'

type Props = {
  tags: GroupTag[]
  value: string[]
  onChange: (tags: string[]) => void
  label: string
}

/** Any number of the group's tags can be on at once. */
export function RolePicker({ tags, value, onChange, label }: Props) {
  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((tag) => tag !== id) : [...value, id])

  if (tags.length === 0)
    return <span className="role-empty">This group has no skill tags yet.</span>

  return (
    <div className="role-picker" role="group" aria-label={label}>
      {tags.map((tag) => {
        const on = value.includes(tag.id)
        return (
          <button
            key={tag.id}
            type="button"
            className={`role-option${on ? ' on' : ''}`}
            aria-pressed={on}
            title={tag.label}
            onClick={() => toggle(tag.id)}
          >
            {tag.label}
          </button>
        )
      })}
    </div>
  )
}
