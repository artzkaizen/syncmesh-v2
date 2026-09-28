require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'RNNearby'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license']
  s.author         = 'SyncMesh'
  s.homepage       = 'https://github.com/sync-mesh'
  # AWDL's floor. Wi-Fi Aware is weak-linked and gated at runtime, so one binary serves both —
  # a hard link against WiFiAware.framework would refuse to launch on everything below iOS 26.
  s.platforms      = { :ios => '16.0' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/sync-mesh/rn-nearby.git', tag: s.version.to_s }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks     = ['Network', 'CryptoKit']
  s.weak_frameworks = ['WiFiAware', 'DeviceDiscoveryUI']

  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = 'ios/**/*.{h,m,mm,swift}'
end
