'use strict';

function classifyOutcome(events) {
  if (!events || events.length === 0) return 'no_events';

  for (const e of events) {
    if (e.type === 'tool_use' && e.part?.state?.status === 'error') {
      const err = String(e.part?.state?.error || '');
      if (err.includes('rejected permission') || err.includes('external_directory')) {
        return 'permission_rejected';
      }
      if (err.includes('invalid arguments') || err.includes('SchemaError')) {
        return 'validation_error';
      }
    }
  }

  const hasAnyError = events.some(e => e.type === 'error');
  if (!hasAnyError && events.length >= 1) {
    const last = events[events.length - 1];
    if (last.type === 'step_finish' && last.part?.reason === 'unknown') {
      let lastStepStart = -1;
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].type === 'step_start') {
          lastStepStart = i;
          break;
        }
      }
      const afterStart = lastStepStart >= 0
        ? events.slice(lastStepStart + 1)
        : events;
      const hasToolUseAfter = afterStart.some(e => e.type === 'tool_use');
      if (!hasToolUseAfter) {
        return 'abandoned';
      }
    }
  }

  // События уровня раннера (сеть, API, краш) — не success, даже если
  // tool_use-ошибки не классифицировались выше
  if (hasAnyError) return 'error';

  return 'success';
}

function buildDiagnosis(events, job) {
  const outcome = classifyOutcome(events);

  let prompt = null;
  const userText = events.find(e => e.role === 'user' && e.part?.text);
  if (userText) {
    prompt = userText.part.text;
  } else {
    const firstText = events.find(e => e.part?.text);
    if (firstText) prompt = firstText.part.text;
  }

  const toolCalls = events
    .filter(e => e.type === 'tool_use')
    .map(e => ({
      tool: e.part?.tool ?? null,
      status: e.part?.state?.status ?? null,
      error: e.part?.state?.error ?? null,
    }));

  const lastErrorTool = toolCalls.filter(t => t.status === 'error').pop();
  const lastErrorMessage = lastErrorTool?.error ?? null;

  const lastErrorIdx = events.reduce((idx, e, i) => {
    if (e.type === 'tool_use' && e.part?.state?.status === 'error') return i;
    return idx;
  }, -1);

  let textAfterLastError = '';
  if (lastErrorIdx >= 0) {
    textAfterLastError = events
      .slice(lastErrorIdx + 1)
      .filter(e => e.type === 'text' && e.part?.text)
      .map(e => e.part.text)
      .join('\n');
  }

  const resumedAfterError = lastErrorIdx >= 0 && events
    .slice(lastErrorIdx + 1)
    .some(e => e.type === 'tool_use');

  return {
    outcome,
    prompt,
    toolCalls,
    lastErrorMessage,
    textAfterLastError,
    resumedAfterError,
  };
}

module.exports = { classifyOutcome, buildDiagnosis };
