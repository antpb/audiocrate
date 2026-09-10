import { defineConfig } from 'vitest/config';
import { workletUrlStub } from './vitest-worklet-stub';

export default defineConfig({
  plugins: [workletUrlStub()],
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
