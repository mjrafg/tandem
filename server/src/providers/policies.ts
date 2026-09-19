/**
 * What each role may do — decided here, once, for every provider.
 *
 * Provider selection and role authority are separate concerns. Running Builder
 * and Reviewer on the same backend must not give the Reviewer the Builder's
 * write access or its tools, and moving a role to another backend must not
 * quietly change what it is allowed to do. So the policy is a property of the
 * ROLE, and the adapter's job is to enforce as much of it as its transport can.
 *
 * These values reproduce exactly what each role could do before the provider
 * layer existed; nothing here widens or narrows an existing boundary.
 */
import type { AiRole } from '../../../shared/types';
import type { RoleExecutionPolicy } from './types';

const POLICIES: Record<AiRole, RoleExecutionPolicy> = {
  // does the work: writes the project, runs commands, keeps the app state
  builder: {
    filesystem: 'read-write',
    workdirTools: true,
    browserTools: true,
    integrationTools: true,
    directorTools: false,
  },
  // the last repair round — Builder authority, different prompt semantics
  final_repair: {
    filesystem: 'read-write',
    workdirTools: true,
    browserTools: true,
    integrationTools: true,
    directorTools: false,
  },
  // judges the result: inspects everything, changes nothing, and never gets
  // the Builder's app-state tools (which is what keeps a review independent)
  builder_reviewer: {
    filesystem: 'read-only',
    workdirTools: false,
    browserTools: true,
    integrationTools: true,
    directorTools: false,
  },
  // judges the Director's decisions: the same read-only posture
  director_reviewer: {
    filesystem: 'read-only',
    workdirTools: false,
    browserTools: true,
    integrationTools: true,
    directorTools: false,
  },
  // the historical generic reviewer — identical to builder_reviewer; kept so a
  // recorded role can still be looked up, never resolved for new work
  reviewer: {
    filesystem: 'read-only',
    workdirTools: false,
    browserTools: true,
    integrationTools: true,
    directorTools: false,
  },
  // decides a Builder/Reviewer disagreement: reads the repository to weigh
  // evidence, changes nothing, orchestrates nothing
  arbiter: {
    filesystem: 'read-only',
    workdirTools: false,
    browserTools: false,
    integrationTools: false,
    directorTools: false,
  },
  // orchestrates: reads the repository, drives sessions through its own tools
  director: {
    filesystem: 'read-only',
    workdirTools: false,
    browserTools: false,
    integrationTools: false,
    directorTools: true,
  },
};

export function policyFor(role: AiRole): RoleExecutionPolicy {
  return POLICIES[role];
}

/**
 * The role FAMILY tool authorization is filtered by: integration tool grants,
 * skills and browser buckets are configured per family, so both reviewers
 * receive "reviewer" tools and both Builder roles receive "builder" tools.
 * The precise logical role still goes on every record.
 */
export function roleFamily(role: AiRole): 'builder' | 'reviewer' {
  return role === 'builder_reviewer' || role === 'director_reviewer' || role === 'reviewer' || role === 'arbiter' || role === 'director'
    ? 'reviewer' : 'builder';
}
