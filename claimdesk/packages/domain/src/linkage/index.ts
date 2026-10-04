// linkage module — BLUEPRINT §3.9 connected-party and witness checker. Named exports only.
export {
  findConnections,
  compareParties,
  FIELD_CONFIDENCE,
  type Connection,
  type ConnectionField,
  type RegisterName,
  type LinkableParty,
  type LinkageRegisters,
  type FindConnectionsOptions
} from './connections.js';
export {
  witnessIndependence,
  WITNESS_FIELD_PENALTY,
  WITNESS_REGISTER_PENALTY,
  CORROBORATION_SUGGESTIONS,
  type WitnessIndependence
} from './witness.js';
export {
  normalisePhone,
  normaliseEmail,
  normalisePostcode,
  normaliseAddressKey,
  normaliseBankKey,
  nameTokens,
  tokenJaccard,
  jaro,
  jaroWinkler,
  nameSimilarity,
  type NameSimilarity
} from './normalise.js';
