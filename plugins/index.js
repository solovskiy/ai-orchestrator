/**
 * Custom OpenCode plugin: git_commit tool
 *
 * Позволяет агенту делать git commit без прямого доступа к git.exe.
 * Агент передаёт готовое сообщение коммита, а инструмент выполняет
 * git add -A && git commit в рабочей директории.
 */

const { execSync } = require('child_process');
const path = require('path');

module.exports = async (context) => {
  return {
    tool: {
      git_commit: {
        description: 'Create a git commit with all staged changes. Pass the commit message explaining what was changed and why.',
        args: {
          message: {
            type: 'string',
            description: 'Commit message explaining the changes (should be descriptive, e.g., "fix: resolve permission issue in api/users.ts")'
          }
        },
        async execute(args) {
          try {
            const cwd = context.worktree || context.directory;

            // git add -A
            execSync('git add -A', { cwd, encoding: 'utf-8' });

            // git commit -m <message>
            const result = execSync(`git commit -m "${args.message.replace(/"/g, '\\"')}"`, {
              cwd,
              encoding: 'utf-8',
              stdio: ['pipe', 'pipe', 'pipe']
            });

            return {
              title: 'Commit created',
              output: result.trim() || 'Changes committed successfully.',
              metadata: { message: args.message }
            };
          } catch (error) {
            // git commit может упасть если нет изменений или конфликт
            const stderr = error.stderr ? error.stderr.toString() : error.message;
            if (stderr.includes('nothing to commit')) {
              return {
                title: 'No changes to commit',
                output: 'Working tree is clean — no staged changes to commit.',
                metadata: { message: args.message }
              };
            }
            throw new Error(`git commit failed: ${stderr}`);
          }
        }
      }
    }
  };
};
