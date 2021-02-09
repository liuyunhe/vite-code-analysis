const vueJsxPlugin = require('@vitejs/plugin-vue-jsx')

/**
 * @type {import('vite').UserConfig}
 */
module.exports = {
  plugins: [
    vueJsxPlugin({
      extensions: ['.jsx', '.tsx', '.tesx']
    })
  ],
  build: {
    // to make tests faster
    minify: false
  }
}
