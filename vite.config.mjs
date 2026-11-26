import { defineConfig } from 'vite';
export default defineConfig({
  build:{outDir:'dist'},
  server:{
    watch:{ignored:['**/data/**']},
    fs:{deny:['.env','.env.*','*.{crt,pem}','**/.git/**','**/data/**','**/*.sqlite*']},
  },
});
