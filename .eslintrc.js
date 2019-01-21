{
    "env": {
      "node": true,
      "browser": true,
      "es6": true,
      "mocha": true
    },
    "extends": "eslint:recommended",
    "parserOptions": {
      "sourceType": "module",
      "ecmaVersion": 2017
    },
    "rules": {
      "indent": ["error", 2, { "SwitchCase": 1 }],
      "linebreak-style": ["error", "unix"],
      "semi": ["error", "never"],
      "no-console": "off"
    }
  }
