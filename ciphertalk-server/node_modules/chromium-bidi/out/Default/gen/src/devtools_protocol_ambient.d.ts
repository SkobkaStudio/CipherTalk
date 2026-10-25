import type * as ProtocolModule from '../../blink/public/devtools_protocol/types/protocol.js';
import type * as ProtocolMappingModule from '../../blink/public/devtools_protocol/types/protocol-mapping.js';
declare module 'devtools-protocol' {
  export import Protocol = ProtocolModule.Protocol;
  export default Protocol;
}
declare module 'devtools-protocol/types/protocol-mapping.js' {
  export import ProtocolMapping = ProtocolMappingModule.ProtocolMapping;
  export default ProtocolMapping;
}
