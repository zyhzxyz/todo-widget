import { useEffect, useState, useSyncExternalStore } from 'react';
import { BusinessStore } from '../data/businessStore';
import type { BusinessData } from '../../shared/domain';

export function useBusinessData(loadLocal: () => BusinessData) {
  const [store] = useState(() => new BusinessStore(loadLocal));
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => { store.start(); return () => store.dispose(); }, [store]);
  return { store, view };
}
