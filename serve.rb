require 'webrick'
server = WEBrick::HTTPServer.new(
  Port: 5173,
  DocumentRoot: '/Users/elishamerel/Documents/RealVerdictFolder'
)
trap('INT') { server.shutdown }
server.start
