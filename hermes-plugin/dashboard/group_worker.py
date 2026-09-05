"""Bounded analysis-only profile turn; private file IPC, never CLI stdout.

The parent pins HERMES_HOME before this process imports any Hermes module.
All runtime credentials stay inside Hermes' canonical provider resolver.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import sys

SAFE_MODES = frozenset({'chat_completions', 'anthropic_messages', 'codex_responses'})


def run_turn(prompt, cli_type, agent_type):
    cli = cli_type(toolsets=[], max_turns=1, run_budget=80, verbose=False)
    agent = None
    try:
        if not cli._ensure_runtime_credentials() or cli.api_mode not in SAFE_MODES:
            raise RuntimeError('Unsupported or unavailable runtime')
        agent = agent_type(
            model=cli.model, api_key=cli.api_key, base_url=cli.base_url,
            provider=cli.provider, requested_provider=cli.requested_provider,
            api_mode=cli.api_mode, credential_pool=getattr(cli, '_credential_pool', None),
            max_tokens=min(cli.max_tokens or 4096, 4096), max_iterations=1,
            enabled_toolsets=[], quiet_mode=True, save_trajectories=False,
            skip_context_files=True, skip_memory=True, skip_background_review=True,
            session_db=None, run_budget_seconds=80, checkpoints_enabled=False,
            reasoning_config=cli.reasoning_config,
            ephemeral_system_prompt=(cli.system_prompt or '') +
                '\nAgent Hub: modo de análisis. No hay herramientas ni permisos de acciones externas. '
                'Devuelve propuestas verificables, no afirmes haber ejecutado acciones.',
        )
        if agent.tools or agent.valid_tool_names or agent.api_mode not in SAFE_MODES:
            raise RuntimeError('Unsafe tool surface')
        result = agent.run_conversation(user_message=prompt)
        text = result.get('final_response')
        if (result.get('completed') is not True or result.get('failed') or result.get('partial')
                or result.get('interrupted') or result.get('error') or not isinstance(text, str)
                or not text.strip() or len(text)>24000):
            raise RuntimeError('No confirmed final response')
        return {'ok': True, 'text': text}
    finally:
        if agent is not None:
            agent.close()
        db = getattr(cli, '_session_db', None)
        if db is not None:
            db.close()


def main():
    output = Path(sys.argv[1])
    if sys.platform == 'linux':
        import ctypes
        import signal
        parent = os.getppid()
        if ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
            raise RuntimeError('Cannot bind worker lifetime')
        if os.getppid() != parent or parent == 1:
            raise RuntimeError('Parent exited')
    # File created with private mode even before writing. The containing dir is
    # private and supplied only by the parent, not from a browser request.
    os.umask(0o077)
    data = json.loads(sys.stdin.buffer.read(256001))
    prompt = data.get('prompt')
    if not isinstance(prompt,str) or not prompt or len(prompt)>240000:
        raise ValueError('Invalid prompt')
    from cli import HermesCLI
    from run_agent import AIAgent
    result = run_turn(prompt, HermesCLI, AIAgent)
    output.write_text(json.dumps(result, ensure_ascii=False), encoding='utf-8')


if __name__ == '__main__':
    try:
        main()
    except BaseException:
        # Do not leak diagnostics, keys, auth files or provider response bodies.
        sys.exit(1)
