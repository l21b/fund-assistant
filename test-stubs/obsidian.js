class EmptyClass {}

module.exports = {
  Modal: EmptyClass,
  Notice: EmptyClass,
  Plugin: EmptyClass,
  PluginSettingTab: EmptyClass,
  Setting: EmptyClass,
  requestUrl: async () => { throw new Error("requestUrl is not available in unit tests"); },
};
