import { useState, useCallback } from 'react';
import { getApplications, createApplication, updateApplication, deleteApplication } from '../api';
import type { Application, Filters } from '../types';

export function useApplications() {
	const [applications, setApplications] = useState<Application[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// useCallback required — used in a useEffect dep array in App.tsx
	const fetchAll = useCallback(async (filters: Filters = { search: '' }) => {
		setLoading(true);
		setError(null);
		try {
			const data = await getApplications(filters);
			setApplications(data);
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Unknown error');
		} finally {
			setLoading(false);
		}
	}, []);

	const add = async (data: Omit<Application, 'id' | 'created_at' | 'updated_at'>): Promise<Application> => {
		const created = await createApplication(data);
		setApplications(prev => [created, ...prev]);
		return created;
	};

	const update = async (id: string, data: Partial<Application>): Promise<Application> => {
		const updated = await updateApplication(id, data);
		setApplications(prev => prev.map(a => a.id === id ? updated : a));
		return updated;
	};

	const remove = async (id: string): Promise<void> => {
		await deleteApplication(id);
		setApplications(prev => prev.filter(a => a.id !== id));
	};

	return { applications, loading, error, fetchAll, add, update, remove };
}
