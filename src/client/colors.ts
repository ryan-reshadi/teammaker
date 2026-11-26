/** Eight accents that stay legible on the warm paper background. */
export const TEAM_COLORS = [
  '#2f6f5e',
  '#b4622d',
  '#3f5f8f',
  '#8a5a8f',
  '#5c7a34',
  '#a8474a',
  '#a8862b',
  '#4b6a72',
] as const

export const teamColor = (index: number) =>
  TEAM_COLORS[index % TEAM_COLORS.length]
