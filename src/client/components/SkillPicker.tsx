const LEVELS = Array.from({ length: 10 }, (_, index) => index + 1)

type Props = {
  value: number
  onChange: (value: number) => void
  label: string
}

/** Ten ticks plus the number, so the rating is fast to set and hard to misread. */
export function SkillPicker({ value, onChange, label }: Props) {
  return (
    <div className="skill" role="radiogroup" aria-label={label}>
      <div className="skill-ticks">
        {LEVELS.map((level) => (
          <button
            key={level}
            type="button"
            role="radio"
            aria-checked={level === value}
            aria-label={`${level} out of 10`}
            title={`${level} / 10`}
            className={`skill-tick${level <= value ? ' filled' : ''}`}
            onClick={() => onChange(level)}
          />
        ))}
      </div>
      <output className="skill-value" aria-hidden="true">
        {value}
      </output>
    </div>
  )
}
