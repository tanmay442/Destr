// pdf-parse's index.js has a debug branch that reads a bundled test PDF;
// we import the lib entry instead. This declares that module path.
declare module 'pdf-parse/lib/pdf-parse.js' {
  import pdf from 'pdf-parse';
  export default pdf;
}
