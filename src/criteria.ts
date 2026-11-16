import { Type } from "@sinclair/typebox";
import { entityKey } from "./sources.js";
import type { Criterion, Candidate } from "./types.js";
export const criterionSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 100 }),
  description: Type.String({ minLength: 1, maxLength: 4000 }),
  weight: Type.Number({ minimum: 1, maximum: 10 }),
  required: Type.Boolean(),
  appliesTo: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), {
      minItems: 1,
      maxItems: 10,
      uniqueItems: true,
    }),
  ),
});
export function criterionApplies(c: Criterion, url: string) {
  const key = entityKey(url);
  return (
    !c.appliesTo || (!!key && c.appliesTo.some((u) => entityKey(u) === key))
  );
}
export function uncoveredCriteria(
  criteria: Criterion[],
  candidates: Pick<Candidate, "url">[],
) {
  return criteria.filter(
    (c) =>
      c.required &&
      c.appliesTo &&
      !candidates.some((candidate) => criterionApplies(c, candidate.url)),
  );
}
