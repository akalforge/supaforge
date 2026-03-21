import Scan from './scan'

export default class Hukam extends Scan {
  static override description = 'The daily Hukamnama of your database 🙏 (alias for scan)'

  static override examples = ['<%= config.bin %> hukam']

  protected override isHukam = true
}
