import { ROLES } from '../../shared/roles'

type Props = {
  value: string[]
  onChange: (tags: string[]) => void
  label: string
}

/** Any number of roles can be on at once; a player can be a sniper and an IGL. */
export function RolePicker({ value, onChange, label }: Props) {
  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((tag) => tag !== id) : [...value, id])

  return (
    <div className="role-picker" role="group" aria-label={label}>
      {ROLES.map((role) => {
        const on = value.includes(role.id)
        return (
          <button
            key={role.id}
            type="button"
            className={`role-option${on ? ' on' : ''}`}
            aria-pressed={on}
            title={role.hint}
            onClick={() => toggle(role.id)}
          >
            {role.label}
          </button>
        )
      })}
    </div>
  )
}
