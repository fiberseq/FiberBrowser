import { useState, useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useDafcStore } from '../../../stores/dafcStore';
import {
  getLinkedSessions,
  createLinkedSession,
  deleteLinkedSession
} from '../../../api/dafc';
import type { LinkedSession, SplitViewMode } from '../../../types/dafc';

function fallbackSplitModeLabel(mode?: SplitViewMode | null): string {
  switch (mode) {
    case 'molecule_linked':
      return 'Molecule-linked';
    case 'region_independent':
      return 'Region-independent';
    case 'coordinate_synced':
      return 'Coordinate-synced';
    case 'unassigned':
    default:
      return 'Empty';
  }
}

function sessionModeLabel(session: LinkedSession): string {
  return session.split_view_semantics?.label || fallbackSplitModeLabel(session.split_view_mode);
}

export function LinkedSessionPanel() {
  const {
    linkedSessions,
    setLinkedSessions,
    currentLinkedSessionId,
    setCurrentLinkedSession,
    linkedReadCount,
  } = useDafcStore(useShallow(s => ({
    linkedSessions: s.linkedSessions,
    setLinkedSessions: s.setLinkedSessions,
    currentLinkedSessionId: s.currentLinkedSessionId,
    setCurrentLinkedSession: s.setCurrentLinkedSession,
    linkedReadCount: s.linkedReadCount,
  })));

  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  // Load sessions on mount
  useEffect(() => {
    const loadSessions = async () => {
      try {
        const { sessions } = await getLinkedSessions();
        setLinkedSessions(sessions);
      } catch (e) {
        console.error('Failed to load sessions:', e);
      }
    };
    loadSessions();
  }, [setLinkedSessions]);

  const handleCreateSession = async () => {
    setLoading(true);
    try {
      const { session_id } = await createLinkedSession();
      const { sessions } = await getLinkedSessions();
      setLinkedSessions(sessions);
      setCurrentLinkedSession(session_id);
      setIsOpen(false);
    } catch (e) {
      console.error('Failed to create session:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteSession = async (sessionId: string) => {
    try {
      await deleteLinkedSession(sessionId);
      const { sessions } = await getLinkedSessions();
      setLinkedSessions(sessions);

      if (currentLinkedSessionId === sessionId) {
        setCurrentLinkedSession(null);
      }
    } catch (e) {
      console.error('Failed to delete session:', e);
    }
  };

  const currentSession = linkedSessions.find((s: LinkedSession) => s.id === currentLinkedSessionId);

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-3 py-1.5 bg-gray-100 dark:bg-white/10 rounded hover:bg-gray-200 dark:hover:bg-white/20 text-sm"
      >
        <span className="text-gray-600 dark:text-gray-400">Session:</span>
        <span className="font-medium dark:text-gray-200">
          {currentLinkedSessionId || 'None'}
        </span>
        {currentSession && (
          <span className="bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 px-1.5 py-0.5 rounded text-xs">
            {sessionModeLabel(currentSession)}
          </span>
        )}
        {linkedReadCount > 0 && (
          <span className="bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 px-1.5 py-0.5 rounded text-xs">
            {linkedReadCount} reads
          </span>
        )}
        <svg
          className={`w-4 h-4 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-10"
            onClick={() => setIsOpen(false)}
          />

          {/* Dropdown */}
          <div className="absolute right-0 top-full mt-1 w-72 bg-white dark:bg-dark-surface rounded-lg shadow-lg dark:shadow-dropdown-dark border dark:border-white/10 z-20">
            <div className="p-3 border-b dark:border-white/10">
              <button
                onClick={handleCreateSession}
                disabled={loading}
                className="w-full px-3 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 text-sm font-medium disabled:opacity-50"
              >
                {loading ? 'Creating...' : '+ New Linked Session'}
              </button>
            </div>

            <div className="max-h-64 overflow-y-auto">
              {linkedSessions.length === 0 ? (
                <div className="p-4 text-center text-gray-500 dark:text-gray-400 text-sm">
                  No sessions yet
                </div>
              ) : (
                <ul className="py-1">
                  {linkedSessions.map((session: LinkedSession) => (
                    <li key={session.id}>
                      <div
                        className={`px-3 py-2 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-white/5 ${
                          session.id === currentLinkedSessionId ? 'bg-blue-50 dark:bg-blue-900/20' : ''
                        }`}
                      >
                        <button
                          onClick={() => {
                            setCurrentLinkedSession(session.id);
                            setIsOpen(false);
                          }}
                          className="flex-1 text-left flex items-center gap-2"
                        >
                          <span
                            className={`w-2 h-2 rounded-full ${
                              session.has_reads ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'
                            }`}
                          />
                          <span className="flex-1 min-w-0">
                            <span className="block font-mono text-sm dark:text-gray-200 truncate">{session.id}</span>
                            <span className="block text-[11px] text-gray-500 dark:text-gray-400 truncate">
                              {sessionModeLabel(session)}
                            </span>
                          </span>
                          <span className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
                            {session.n_reads} reads
                          </span>
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteSession(session.id);
                          }}
                          className="text-gray-400 dark:text-gray-500 hover:text-red-500 p-1"
                        >
                          ×
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="p-2 border-t dark:border-white/10 text-xs text-gray-500 dark:text-gray-400 text-center">
              Sessions hold linked molecules or independent region selections
            </div>
          </div>
        </>
      )}
    </div>
  );
}
