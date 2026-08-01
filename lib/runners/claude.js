'use strict';

module.exports = {
  name: 'claude',

  capabilities: {
    resume: true,
    cost: true,
    json: true,
  },

  buildArgs(job, prompt) {
    const args = ['claude', '-p', '--output-format', 'stream-json'];

    if (job.model) {
      const modelName = job.model.includes('/') ? job.model.split('/')[1] : job.model;
      args.push('--model', modelName);
    }
    if (job.resume && job.sessionId) {
      args.push('--resume', job.sessionId);
    }
    if (typeof job.maxTurns === 'number') {
      args.push('--max-turns', String(job.maxTurns));
    }
    args.push(prompt);
    return args;
  },

  parse(events) {
    let sessionId = null;
    let error = null;
    let cost = null;
    const texts = [];
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 };

    for (const e of events) {
      if (!e || typeof e !== 'object') continue;

      if (!sessionId && e.session_id) sessionId = e.session_id;
      if (!sessionId && e.sessionId) sessionId = e.sessionId;

      switch (e.type) {
        case 'text':
        case 'message':
          if (typeof e.text === 'string') texts.push(e.text);
          if (typeof e.content === 'string') texts.push(e.content);
          break;

        case 'error':
          error = e.message || e.error || JSON.stringify(e).slice(0, 500);
          break;

        case 'result':
          if (typeof e.text === 'string') texts.push(e.text);
          if (typeof e.content === 'string') texts.push(e.content);
          if (typeof e.total_cost_usd === 'number') cost = e.total_cost_usd;
          if (e.usage) {
            tokens.input += e.usage.input_tokens || 0;
            tokens.output += e.usage.output_tokens || 0;
            tokens.cacheRead += e.usage.cache_read_input_tokens || 0;
            tokens.cacheCreation += e.usage.cache_creation_input_tokens || 0;
          }
          if (e.is_error === true && !error) {
            error = e.subtype || e.error || e.message || JSON.stringify(e).slice(0, 500);
          }
          break;
      }
    }

    tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation;

    return {
      sessionId,
      resultText: texts.join('\n\n').trim(),
      tokens,
      cost,
      error,
    };
  },
};
