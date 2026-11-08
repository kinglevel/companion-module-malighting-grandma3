import { generateEslintConfig } from '@companion-module/tools/eslint/config.mjs'

const baseConfig = await generateEslintConfig({
	enableTypescript: true,
})

export default [
	...baseConfig,
	{
		// Unit tests use dev dependencies (vitest) and are never packaged
		files: ['src/**/__tests__/**/*.ts'],
		rules: {
			'n/no-unpublished-import': 'off',
		},
	},
]
