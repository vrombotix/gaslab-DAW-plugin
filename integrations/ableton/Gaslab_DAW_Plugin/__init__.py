# Gaslab DAW Plugin for Ableton Live - Control Surface entry point.
#
# UNVERIFIED: never loaded into a real Live install. Requires Live 12.0.5+
# for the import itself (older Live loads the script and reports a clear
# error instead of importing).
#
# Install: the desktop app copies this "Gaslab_DAW_Plugin" folder into Live's
# User Library "Remote Scripts" folder on startup (`daw-agent
# install-bridges`; path from paths::abletonRemoteScriptsDir()). Then select
# "Gaslab_DAW_Plugin" once under Settings > Link, Tempo & MIDI > Control
# Surface. It auto-loads with every set from then on - no per-project step,
# unlike Ardour's per-session hook.

from .daw_plugin import GaslabDAWPlugin


def create_instance(c_instance):
    return GaslabDAWPlugin(c_instance)
