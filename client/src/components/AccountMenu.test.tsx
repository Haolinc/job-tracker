import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AccountMenu from './AccountMenu';

const user = userEvent.setup();
const base = { email: 'jane.doe@gmail.com', signOutDisabled: false, onSignOut: vi.fn() };

describe('AccountMenu', () => {
	it('should show the address\'s first character as the avatar, uppercased', () => {
		render(<AccountMenu {...base} />);
		expect(screen.getByTestId('account-avatar-btn')).toHaveTextContent('J');
	});

	it('should fall back to a placeholder initial when the address is unknown', () => {
		// getAccountEmail returns null when the Gmail profile lookup fails — the badge still renders.
		render(<AccountMenu {...base} email={null} />);
		expect(screen.getByTestId('account-avatar-btn')).toHaveTextContent('?');
	});

	it('should reveal the full address only after the avatar is clicked', async () => {
		render(<AccountMenu {...base} />);
		expect(screen.queryByTestId('account-menu')).toBeNull();
		await user.click(screen.getByTestId('account-avatar-btn'));
		expect(screen.getByTestId('account-menu-email')).toHaveTextContent('jane.doe@gmail.com');
	});

	it('should close the popover on a second avatar click', async () => {
		render(<AccountMenu {...base} />);
		await user.click(screen.getByTestId('account-avatar-btn'));
		await user.click(screen.getByTestId('account-avatar-btn'));
		expect(screen.queryByTestId('account-menu')).toBeNull();
	});

	it('should close the popover on a click outside it', async () => {
		render(<><AccountMenu {...base} /><button data-testid="elsewhere">elsewhere</button></>);
		await user.click(screen.getByTestId('account-avatar-btn'));
		await user.click(screen.getByTestId('elsewhere'));
		expect(screen.queryByTestId('account-menu')).toBeNull();
	});

	it('should close the popover on Escape', async () => {
		render(<AccountMenu {...base} />);
		await user.click(screen.getByTestId('account-avatar-btn'));
		await user.keyboard('{Escape}');
		expect(screen.queryByTestId('account-menu')).toBeNull();
	});

	it('should call onSignOut and close the popover when Sign out is clicked', async () => {
		const onSignOut = vi.fn();
		render(<AccountMenu {...base} onSignOut={onSignOut} />);
		await user.click(screen.getByTestId('account-avatar-btn'));
		await user.click(screen.getByTestId('account-menu-signout-btn'));
		expect(onSignOut).toHaveBeenCalledTimes(1);
		expect(screen.queryByTestId('account-menu')).toBeNull();
	});

	it('should NOT sign out while a sync is running', async () => {
		// Signing out revokes the very tokens the running sync is using.
		const onSignOut = vi.fn();
		render(<AccountMenu {...base} signOutDisabled signOutDisabledReason="Wait for the sync" onSignOut={onSignOut} />);
		await user.click(screen.getByTestId('account-avatar-btn'));
		const signOutButton = screen.getByTestId('account-menu-signout-btn');
		expect(signOutButton).toBeDisabled();
		await user.click(signOutButton);
		expect(onSignOut).not.toHaveBeenCalled();
	});
});
