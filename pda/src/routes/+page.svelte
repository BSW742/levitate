<script lang="ts">
	const WORKER_URL = 'https://levitate-sync.ben-6a6.workers.dev';
	const SYNC_PASSWORD_KEY = 'levitate-sync-password';

	let syncPassword = $state(localStorage.getItem(SYNC_PASSWORD_KEY) || '');
	let isAuthenticated = $state(!!syncPassword);
	let passwordInput = $state('');

	let avatar = $state<string | null>(null);
	let rawImage = $state<string | null>(null);
	let name = $state('');
	let role = $state('');
	let company = $state('');
	let phone = $state('');
	let email = $state('');
	let website = $state('');
	let saving = $state(false);
	let scanning = $state(false);
	let message = $state<{ type: 'success' | 'error'; text: string } | null>(null);

	// Cropper state
	let showCropper = $state(false);
	let cropX = $state(50);
	let cropY = $state(120);
	let cropSize = $state(100);
	let isDragging = $state(false);
	let dragStart = { x: 0, y: 0, cropX: 0, cropY: 0 };

	let fileInput: HTMLInputElement;
	let cameraInput: HTMLInputElement;
	let scanInput: HTMLInputElement;
	let cropperImg: HTMLImageElement;

	function titleCase(str: string): string {
		return str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
	}

	function handleLogin() {
		if (passwordInput.trim()) {
			syncPassword = passwordInput.trim();
			localStorage.setItem(SYNC_PASSWORD_KEY, syncPassword);
			isAuthenticated = true;
		}
	}

	function handleLogout() {
		localStorage.removeItem(SYNC_PASSWORD_KEY);
		syncPassword = '';
		isAuthenticated = false;
		passwordInput = '';
	}

	function handleImageSelect(e: Event) {
		const file = (e.target as HTMLInputElement).files?.[0];
		if (!file) return;

		const reader = new FileReader();
		reader.onload = (e) => {
			const dataUrl = e.target?.result as string;
			const img = new Image();
			img.onload = () => {
				const canvas = document.createElement('canvas');
				const size = 150;
				canvas.width = size;
				canvas.height = size;
				const ctx = canvas.getContext('2d')!;
				const minDim = Math.min(img.width, img.height);
				const sx = (img.width - minDim) / 2;
				const sy = (img.height - minDim) / 2;
				ctx.drawImage(img, sx, sy, minDim, minDim, 0, 0, size, size);
				avatar = canvas.toDataURL('image/jpeg', 0.8);
			};
			img.src = dataUrl;
		};
		reader.readAsDataURL(file);
	}

	function handleScanSelect(e: Event) {
		const file = (e.target as HTMLInputElement).files?.[0];
		if (!file) return;

		const reader = new FileReader();
		reader.onload = (e) => {
			const imageData = e.target?.result as string;
			rawImage = imageData;
			scanLinkedInScreenshot(imageData);
		};
		reader.readAsDataURL(file);
	}

	async function scanLinkedInScreenshot(imageData: string) {
		if (!imageData) return;

		scanning = true;
		message = null;

		try {
			const response = await fetch(`${WORKER_URL}/scan`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-Sync-Password': syncPassword
				},
				body: JSON.stringify({ image: imageData })
			});

			if (!response.ok) {
				throw new Error('Scan failed');
			}

			const data = await response.json();

			// Populate form fields
			if (data.name) name = titleCase(data.name);
			if (data.role) role = data.role;
			if (data.company) company = data.company;
			if (data.phone) phone = data.phone;
			if (data.email) email = data.email;
			if (data.website) website = data.website;

			// Show cropper modal
			cropX = 50;
			cropY = 120;
			cropSize = 100;
			showCropper = true;

		} catch (err) {
			message = { type: 'error', text: 'Scan failed. Try again.' };
		} finally {
			scanning = false;
		}
	}

	function handleCropStart(e: TouchEvent | MouseEvent) {
		e.preventDefault();
		isDragging = true;
		const point = 'touches' in e ? e.touches[0] : e;
		dragStart = { x: point.clientX, y: point.clientY, cropX, cropY };
	}

	function handleCropMove(e: TouchEvent | MouseEvent) {
		if (!isDragging) return;
		e.preventDefault();
		const point = 'touches' in e ? e.touches[0] : e;
		const dx = point.clientX - dragStart.x;
		const dy = point.clientY - dragStart.y;
		cropX = Math.max(0, dragStart.cropX + dx);
		cropY = Math.max(0, dragStart.cropY + dy);
	}

	function handleCropEnd() {
		isDragging = false;
	}

	function confirmCrop() {
		if (!rawImage || !cropperImg) return;

		const canvas = document.createElement('canvas');
		const size = 150;
		canvas.width = size;
		canvas.height = size;
		const ctx = canvas.getContext('2d')!;

		// Calculate the actual image coordinates from display coordinates
		const displayWidth = cropperImg.clientWidth;
		const naturalWidth = cropperImg.naturalWidth;
		const scale = naturalWidth / displayWidth;

		const srcX = cropX * scale;
		const srcY = cropY * scale;
		const srcSize = cropSize * scale;

		const img = new Image();
		img.onload = () => {
			ctx.drawImage(img, srcX, srcY, srcSize, srcSize, 0, 0, size, size);
			avatar = canvas.toDataURL('image/jpeg', 0.8);
			showCropper = false;
			message = { type: 'success', text: 'Scanned! Review and save.' };
		};
		img.src = rawImage;
	}

	function cancelCrop() {
		showCropper = false;
		rawImage = null;
	}

	async function saveLead() {
		if (!name.trim()) {
			message = { type: 'error', text: 'Name is required' };
			return;
		}

		saving = true;
		message = null;

		try {
			const response = await fetch(WORKER_URL, {
				method: 'GET',
				headers: { 'X-Sync-Password': syncPassword }
			});

			let state = { notes: [], nextZIndex: 1 };
			if (response.ok) {
				state = await response.json();
			}

			const leadText = [name.trim(), role.trim(), company.trim(), phone.trim(), email.trim(), website.trim()].filter(Boolean).join('\n');
			const newNote = {
				id: `note-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
				text: leadText,
				color: '#fef08a',
				x: 100 + Math.random() * 200,
				y: 100 + Math.random() * 200,
				rotation: 0,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				zIndex: state.nextZIndex++,
				isLead: true,
				avatar: avatar || undefined
			};

			state.notes.push(newNote);

			const saveResponse = await fetch(WORKER_URL, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-Sync-Password': syncPassword
				},
				body: JSON.stringify(state)
			});

			if (saveResponse.ok) {
				message = { type: 'success', text: 'Lead saved!' };
				avatar = null;
				rawImage = null;
				name = '';
				role = '';
				company = '';
				phone = '';
				email = '';
				website = '';
			} else {
				throw new Error('Failed to save');
			}
		} catch (err) {
			message = { type: 'error', text: 'Failed to save lead' };
		} finally {
			saving = false;
		}
	}

	function clearForm() {
		avatar = null;
		rawImage = null;
		name = '';
		role = '';
		company = '';
		phone = '';
		email = '';
		website = '';
		message = null;
	}
</script>

<div class="app">
	{#if !isAuthenticated}
		<div class="login">
			<h1>Stiki PDA</h1>
			<p>Enter your sync password to connect</p>
			<input
				type="password"
				bind:value={passwordInput}
				placeholder="Sync password"
				onkeydown={(e) => e.key === 'Enter' && handleLogin()}
			/>
			<button onclick={handleLogin}>Connect</button>
		</div>
	{:else}
		<header>
			<h1>New Lead</h1>
			<button class="logout" onclick={handleLogout}>
				<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>
			</button>
		</header>

		<main>
			<div class="avatar-section">
				<div class="avatar" onclick={() => fileInput.click()}>
					{#if avatar}
						<img src={avatar} alt="Lead" />
					{:else}
						<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
							<circle cx="12" cy="8" r="4"/>
							<path d="M12 14c-4 0-8 2-8 5v1h16v-1c0-3-4-5-8-5z"/>
						</svg>
					{/if}
				</div>
				<div class="avatar-actions">
					<button onclick={() => cameraInput.click()}>
						<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg>
						Camera
					</button>
					<button onclick={() => fileInput.click()}>
						<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
						Gallery
					</button>
					<button class="scan-btn" onclick={() => scanInput.click()} disabled={scanning}>
						<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.35-4.35"></path></svg>
						{scanning ? 'Scanning...' : 'Scan LI'}
					</button>
				</div>
			</div>

			<input type="file" accept="image/*" capture="user" bind:this={cameraInput} onchange={handleImageSelect} hidden />
			<input type="file" accept="image/*" bind:this={fileInput} onchange={handleImageSelect} hidden />
			<input type="file" accept="image/*" bind:this={scanInput} onchange={handleScanSelect} hidden />

			<div class="form">
				<input type="text" bind:value={name} placeholder="Name *" />
				<input type="text" bind:value={role} placeholder="Role" />
				<input type="text" bind:value={company} placeholder="Company" />
				<input type="tel" bind:value={phone} placeholder="Phone" />
				<input type="email" bind:value={email} placeholder="Email" />
				{#if website}
					<a href={website} target="_blank" rel="noopener" class="website-link">Website</a>
				{:else}
					<input type="url" bind:value={website} placeholder="Website" />
				{/if}
			</div>

			{#if message}
				<div class="message {message.type}">{message.text}</div>
			{/if}

			<div class="actions">
				<button class="secondary" onclick={clearForm}>Clear</button>
				<button class="primary" onclick={saveLead} disabled={saving}>
					{saving ? 'Saving...' : 'Save Lead'}
				</button>
			</div>
		</main>
	{/if}
</div>

<!-- Cropper Modal -->
{#if showCropper && rawImage}
	<div class="cropper-modal"
		ontouchmove={handleCropMove}
		onmousemove={handleCropMove}
		ontouchend={handleCropEnd}
		onmouseup={handleCropEnd}
		onmouseleave={handleCropEnd}
	>
		<div class="cropper-header">
			<span>Drag circle over face</span>
		</div>
		<div class="cropper-container">
			<img bind:this={cropperImg} src={rawImage} alt="Screenshot" class="cropper-image" />
			<div
				class="crop-circle"
				style="left: {cropX}px; top: {cropY}px; width: {cropSize}px; height: {cropSize}px;"
				ontouchstart={handleCropStart}
				onmousedown={handleCropStart}
			></div>
		</div>
		<div class="cropper-controls">
			<label>
				Size
				<input type="range" min="60" max="200" bind:value={cropSize} />
			</label>
		</div>
		<div class="cropper-actions">
			<button class="secondary" onclick={cancelCrop}>Cancel</button>
			<button class="primary" onclick={confirmCrop}>Crop</button>
		</div>
	</div>
{/if}

<style>
	:global(*) {
		box-sizing: border-box;
		margin: 0;
		padding: 0;
	}

	:global(body) {
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
		background: #1f2937;
		color: white;
		min-height: 100vh;
	}

	.app {
		min-height: 100vh;
		display: flex;
		flex-direction: column;
	}

	.login {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 24px;
		text-align: center;
	}

	.login h1 {
		font-size: 2rem;
		margin-bottom: 8px;
	}

	.login p {
		color: #9ca3af;
		margin-bottom: 24px;
	}

	.login input {
		width: 100%;
		max-width: 280px;
		padding: 14px 16px;
		font-size: 16px;
		border: none;
		border-radius: 12px;
		background: #374151;
		color: white;
		margin-bottom: 12px;
		text-align: center;
	}

	.login input::placeholder {
		color: #6b7280;
	}

	.login button {
		width: 100%;
		max-width: 280px;
		padding: 14px;
		font-size: 16px;
		font-weight: 600;
		border: none;
		border-radius: 12px;
		background: #fef08a;
		color: #1f2937;
		cursor: pointer;
	}

	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 16px 20px;
		border-bottom: 1px solid #374151;
	}

	header h1 {
		font-size: 1.25rem;
		font-weight: 600;
	}

	.logout {
		background: none;
		border: none;
		color: #9ca3af;
		cursor: pointer;
		padding: 8px;
	}

	main {
		flex: 1;
		padding: 24px 20px;
		display: flex;
		flex-direction: column;
		gap: 24px;
	}

	.avatar-section {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 16px;
	}

	.avatar {
		width: 120px;
		height: 120px;
		border-radius: 50%;
		background: #374151;
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		overflow: hidden;
		border: 3px solid #4b5563;
	}

	.avatar img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.avatar svg {
		width: 48px;
		height: 48px;
		color: #6b7280;
	}

	.avatar-actions {
		display: flex;
		gap: 12px;
	}

	.avatar-actions button {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 10px 16px;
		font-size: 14px;
		border: none;
		border-radius: 8px;
		background: #374151;
		color: white;
		cursor: pointer;
	}

	.avatar-actions .scan-btn {
		background: #3b82f6;
	}

	.avatar-actions .scan-btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.form {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.form input,
	.form textarea {
		width: 100%;
		padding: 14px 16px;
		font-size: 16px;
		border: none;
		border-radius: 12px;
		background: #374151;
		color: white;
		font-family: inherit;
		resize: none;
	}

	.form input::placeholder,
	.form textarea::placeholder {
		color: #6b7280;
	}

	.website-link {
		display: block;
		padding: 14px 16px;
		font-size: 16px;
		border-radius: 12px;
		background: #374151;
		color: #3b82f6;
		text-decoration: none;
		text-align: center;
	}

	.message {
		padding: 12px 16px;
		border-radius: 8px;
		font-size: 14px;
		text-align: center;
	}

	.message.success {
		background: #065f46;
		color: #a7f3d0;
	}

	.message.error {
		background: #991b1b;
		color: #fecaca;
	}

	.actions {
		display: flex;
		gap: 12px;
		margin-top: auto;
		padding-bottom: env(safe-area-inset-bottom, 0);
	}

	.actions button {
		flex: 1;
		padding: 16px;
		font-size: 16px;
		font-weight: 600;
		border: none;
		border-radius: 12px;
		cursor: pointer;
	}

	.actions .secondary {
		background: #374151;
		color: white;
	}

	.actions .primary {
		background: #fef08a;
		color: #1f2937;
	}

	.actions .primary:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	/* Cropper Modal */
	.cropper-modal {
		position: fixed;
		inset: 0;
		background: #1f2937;
		z-index: 100;
		display: flex;
		flex-direction: column;
	}

	.cropper-header {
		padding: 16px 20px;
		text-align: center;
		font-weight: 600;
		border-bottom: 1px solid #374151;
	}

	.cropper-container {
		flex: 1;
		position: relative;
		overflow: auto;
		-webkit-overflow-scrolling: touch;
	}

	.cropper-image {
		display: block;
		width: 100%;
		height: auto;
	}

	.crop-circle {
		position: absolute;
		border: 3px solid #fef08a;
		border-radius: 50%;
		cursor: move;
		touch-action: none;
		box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.5);
	}

	.cropper-controls {
		padding: 16px 20px;
		border-top: 1px solid #374151;
	}

	.cropper-controls label {
		display: flex;
		align-items: center;
		gap: 12px;
		font-size: 14px;
	}

	.cropper-controls input[type="range"] {
		flex: 1;
		height: 4px;
		-webkit-appearance: none;
		background: #374151;
		border-radius: 2px;
	}

	.cropper-controls input[type="range"]::-webkit-slider-thumb {
		-webkit-appearance: none;
		width: 20px;
		height: 20px;
		background: #fef08a;
		border-radius: 50%;
		cursor: pointer;
	}

	.cropper-actions {
		display: flex;
		gap: 12px;
		padding: 16px 20px;
		padding-bottom: calc(16px + env(safe-area-inset-bottom, 0));
	}

	.cropper-actions button {
		flex: 1;
		padding: 16px;
		font-size: 16px;
		font-weight: 600;
		border: none;
		border-radius: 12px;
		cursor: pointer;
	}

	.cropper-actions .secondary {
		background: #374151;
		color: white;
	}

	.cropper-actions .primary {
		background: #fef08a;
		color: #1f2937;
	}
</style>
