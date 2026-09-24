/**
 * The Agent catalog handed to the Project Director.
 *
 * Built fresh from the database on every Director turn — no cache, so an agent
 * created, renamed, enabled, disabled or archived in Admin is reflected in the
 * very next planning decision. The Director chooses by stable ID; routing is
 * its judgment, and nothing here (or anywhere in the engine) maps task wording
 * to a particular agent.
 */
import { defaultAgent, selectableAgents } from './store';

export function agentCatalogText(): string {
  const agents = selectableAgents();
  if (agents.length === 0) {
    return 'AVAILABLE BUILDER AGENTS\n\n(none configured — sessions cannot be started until an enabled Builder Agent exists in Settings → Builder Agents)';
  }
  const def = defaultAgent();
  const lines = agents.map((a) => [
    `ID: ${a.id}`,
    `Name: ${a.name}${a.id === def?.id ? ' (default)' : ''}`,
    `Description: ${a.description || '(no description)'}`,
    ...(a.enforceModel ? [`Model: pinned to ${a.model} · ${a.effort} on ${a.provider}, whatever the Builder role is set to`] : []),
  ].join('\n'));
  return [
    'AVAILABLE BUILDER AGENTS',
    '',
    lines.join('\n\n'),
    '',
    'Choose the most appropriate enabled Builder Agent Profile from this catalog for each session you plan, passing its ID as agent_profile_id. Use the default Agent when specialization provides no meaningful advantage. The same Agent may serve several sessions, different Agents may be mixed within one milestone, and there is no requirement to use every Agent in a project. This catalog is regenerated each turn from the current configuration — never assume agents you saw earlier still exist.',
  ].join('\n');
}
