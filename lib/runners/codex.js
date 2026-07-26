'use strict';

module.exports = {
  name: 'codex',

  capabilities: {
    resume: false,
    cost: false,
    json: false,
  },

  buildArgs(job, prompt) {
    const args = ['codex'];

    if (job.model) {
      const modelName = job.model.includes('/') ? job.model.split('/')[1] : job.model;
      args.push('--model', modelName);
    }
    if (job.cwd) {
      args.push('--dir', job.cwd);
    }

    args.push(prompt);
    return args;
  },

  parse(events) {
    let text = '';
    let error = null;

    for (const e of events) {
      if (!e || typeof e !== 'object') continue;

      if (e.type === 'error') {
        error = e.message || e.error || JSON.stringify(e).slice(0, 500);
      }
      if (typeof e.text === 'string') text += e.text + '\n';
    }

    return {
      sessionId: null,
      resultText: text.trim() || null,
      tokens: null,
      cost: null,
      error,
    };
  },
};
