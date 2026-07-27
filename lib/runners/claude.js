'use strict';

module.exports = {
  name: 'claude',

  capabilities: {
    resume: true,
    cost: false,
    json: true,
  },

  buildArgs(job, prompt) {
    const args = ['claude', '-p', '--output-format', 'stream-json', '--print'];

    if (job.model) {
      const modelName = job.model.includes('/') ? job.model.split('/')[1] : job.model;
      args.push('--model', modelName);
    }
    if (job.resume && job.sessionId) {
      args.push('--resume', job.sessionId);
    }
    args.push(prompt);
    return args;
  },

  parse(events) {
    let sessionId = null;
    let error = null;
    const texts = [];

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
          break;
      }
    }

    return {
      sessionId,
      resultText: texts.join('\n\n').trim(),
      tokens: null,
      cost: null,
      error,
    };
  },
};
