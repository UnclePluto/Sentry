export const normalizePathogens = (values: string[]) =>
  [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();

export const pathogenScope = (values: string[]) =>
  JSON.stringify(normalizePathogens(values));

export function dashboardQuery(input: {
  demo: boolean;
  region: string;
  from?: string;
  to?: string;
  pathogens: string[];
}) {
  const query = new URLSearchParams({
    demo: input.demo ? '1' : '0',
    region: input.region,
  });
  if (input.from) query.set('from', input.from);
  if (input.to) query.set('to', input.to);
  for (const code of normalizePathogens(input.pathogens))
    query.append('pathogen', code);
  return query.toString();
}
