"""Startup adapter: expose only the Agent Hub API owned by limpatexdev-cloud.

Installed as the shared plugin's dashboard/plugin_api.py. The real module remains
inside the explicitly selected profile; its storage root is derived from that
real file, not from this shared adapter. No authentication bypass is introduced.
"""
import importlib.util
import sys
from pathlib import Path

_source = Path('/opt/data/profiles/limpatexdev-cloud/plugins/agent-hub/dashboard/plugin_api.py')
_name = 'agenthub_personal_profile_api'
_spec = importlib.util.spec_from_file_location(_name, _source)
if _spec is None or _spec.loader is None:
    raise RuntimeError('Agent Hub profile backend unavailable')
_module = importlib.util.module_from_spec(_spec)
sys.modules[_name] = _module
try:
    _spec.loader.exec_module(_module)
except Exception:
    sys.modules.pop(_name, None)
    raise
router = _module.router
