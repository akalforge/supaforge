import Diff from './diff.js'

export default class Hukam extends Diff {
  static override hidden = true
  static override description = 'Alias for diff'

  static override examples = ['<%= config.bin %> hukam']

}
