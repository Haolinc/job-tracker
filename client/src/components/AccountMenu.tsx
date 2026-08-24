import { useEffect, useRef, useState } from 'react';

interface AccountMenuProps {
	// The signed-in Gmail address. Null when the server couldn't read it — the badge still renders, it just
	// can't name the mailbox.
	email: string | null;
	// Signing out revokes the very tokens a running sync is using, so the action is blocked mid-sync exactly
	// as the old inline Disconnect link was.
	signOutDisabled: boolean;
	signOutDisabledReason?: string;
	onSignOut: () => void;
}

/** The letter Google-style avatars show: the address's first character, uppercased. '?' when unknown. */
function initialFromEmail(email: string | null): string {
	const firstCharacter = email?.trim().charAt(0);
	return firstCharacter ? firstCharacter.toUpperCase() : '?';
}

// Both avatars (badge and popover) are one indigo circle — indigo rather than the app's blue, which belongs
// to the Sync Gmail button sitting immediately to its left.
const AVATAR_CIRCLE_CLASSES = 'flex items-center justify-center rounded-full bg-indigo-600 text-white font-semibold';

/**
 * The signed-in account badge in the header's top-right corner: an initial avatar that opens a popover
 * naming the connected mailbox and offering sign-out. Only rendered while Gmail is connected — the
 * "Connect Gmail" button in GmailSync covers the disconnected state.
 */
export default function AccountMenu({ email, signOutDisabled, signOutDisabledReason, onSignOut }: AccountMenuProps) {
	const [menuOpen, setMenuOpen] = useState(false);
	const menuContainerRef = useRef<HTMLDivElement>(null);

	// Dismiss on click-outside and Escape, the way every menu of this shape behaves. The listeners exist only
	// while the popover is open, so a closed badge costs nothing. Clicking the avatar itself is inside the
	// container, so it falls through to the button's own toggle instead of being treated as an outside click.
	useEffect(() => {
		if (!menuOpen) return;
		const closeOnOutsideClick = (event: MouseEvent) => {
			if (!menuContainerRef.current?.contains(event.target as Node)) setMenuOpen(false);
		};
		const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
		document.addEventListener('mousedown', closeOnOutsideClick);
		document.addEventListener('keydown', closeOnEscape);
		return () => {
			document.removeEventListener('mousedown', closeOnOutsideClick);
			document.removeEventListener('keydown', closeOnEscape);
		};
	}, [menuOpen]);

	const avatarInitial = initialFromEmail(email);
	return (
		<div ref={menuContainerRef} className="relative">
			<button
				data-testid="account-avatar-btn"
				onClick={() => setMenuOpen(isOpen => !isOpen)}
				aria-haspopup="menu"
				aria-expanded={menuOpen}
				aria-label={email ? `Google account: ${email}` : 'Google account'}
				title={email ?? 'Connected Google account'}
				className={`w-9 h-9 text-sm hover:bg-indigo-700 transition-colors ${AVATAR_CIRCLE_CLASSES}`}
			>{avatarInitial}</button>
			{menuOpen && (
				<div
					data-testid="account-menu"
					role="menu"
					className="absolute right-0 top-full mt-2 w-64 bg-white border border-gray-200 rounded-xl shadow-lg p-4 z-20"
				>
					<div className="flex items-center gap-3">
						<div aria-hidden="true" className={`w-10 h-10 flex-none text-base ${AVATAR_CIRCLE_CLASSES}`}>
							{avatarInitial}
						</div>
						<div className="min-w-0">
							<p className="text-xs text-gray-500">Signed in as</p>
							{/* break-all so a long address wraps inside the popover instead of widening it */}
							<p data-testid="account-menu-email" className="text-sm font-medium text-gray-800 break-all">
								{email ?? 'Google account connected'}
							</p>
						</div>
					</div>
					<p className="mt-3 text-xs text-gray-400">Job Tracker reads this mailbox to find your applications.</p>
					<button
						data-testid="account-menu-signout-btn"
						role="menuitem"
						onClick={() => { setMenuOpen(false); onSignOut(); }}
						disabled={signOutDisabled}
						title={signOutDisabled ? signOutDisabledReason : undefined}
						className="mt-3 w-full px-3 py-2 border border-red-200 bg-white text-red-600 text-sm font-medium rounded-lg hover:bg-red-50 disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:bg-white"
					>Sign out</button>
				</div>
			)}
		</div>
	);
}
