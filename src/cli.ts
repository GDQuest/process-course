import {processFiles} from './index'

const WORKING_DIR = process.cwd() // + '/learn-to-code-from-zero-with-godot-4' // + '/godot-node-essentials' // + '/course-content' // '/learn-to-code-with-godot' // + '/course-content' // + '/godot-node-essentials' // + `/learn-to-code-from-zero-test`
const CONTENT_DIR = `${WORKING_DIR}/content`
const OUTPUT_DIR = `${WORKING_DIR}/content-processed`
const RELEASES_DIR = `${WORKING_DIR}/content-releases`

processFiles(WORKING_DIR, CONTENT_DIR, OUTPUT_DIR, RELEASES_DIR)